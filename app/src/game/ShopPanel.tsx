/**
 * ShopPanel — Ether-currency item shop.
 *
 * Physical location: NPC kiosk in the plaza zone, accessible by walking
 * up to it and pressing R. Opened by WorldScene passing a callback to
 * PhobosGame, which renders this panel as a React overlay.
 *
 * Tabs:
 *   CONSUMABLES — HP/SP potions in all 4 sizes
 *   MATERIALS   — Tier-1 crafting materials (starter supply only)
 *   EQUIPMENT   — Pre-made weapons and armor at varying rarities
 *
 * Currency: ETHER (◆). Displayed in top-right of panel header.
 * Ether is a separate hard currency from PHOBOS coins.
 *
 * All prices from ItemDefinitions POTIONS.buyPrice.
 * Material/equipment prices set here based on tier.
 */

import { useState } from 'react';
import {
  POTIONS, WEAPON_BASES, ARMOR_BASES, RARITIES,
  type GameItem, type PotionDef,
} from './ItemDefinitions';
import { ALL_MATERIALS, type MaterialProps } from './CraftingMaterials';
import { craftWeapon, craftArmor } from './ItemGenerator';
import type { ElementType } from './PlayerClasses';
import { MACHINE_CATALOG, isMachineUnlocked } from './HubBuildingCatalog';
import { BuildingPlacementOverlay } from './BuildingPlacementOverlay';

// ── Shop catalogue helpers ─────────────────────────────────────────────────

const MATERIAL_SHOP_PRICE: Record<number, number> = { 1: 8, 2: 35, 3: 140 };

// Pre-built shop weapon configs: [baseId, headMat, shaftMat, gripMat, element, price]
const SHOP_WEAPONS: Array<{
  baseId: string; headId: string; shaftId: string; gripId: string;
  element: ElementType; price: number; label: string;
}> = [
  { baseId:'sword',   headId:'roughstone_1', shaftId:'palewood_1',  gripId:'cloth_1',    element:'plasma',    price:40,  label:'Iron Sword'       },
  { baseId:'dagger',  headId:'darkstone_1',  shaftId:'heartwood_1', gripId:'pelt_1',     element:'void',      price:45,  label:'Shadow Dagger'    },
  { baseId:'axe',     headId:'roughstone_1', shaftId:'heartwood_1', gripId:'pelt_1',     element:'fire',      price:50,  label:'Rough Axe'        },
  { baseId:'staff',   headId:'lightstone_1', shaftId:'deepwood_1',  gripId:'cloth_1',    element:'ice',       price:55,  label:'Apprentice Staff' },
  { baseId:'ranged',  headId:'roughstone_1', shaftId:'palewood_1',  gripId:'cloth_1',    element:'lightning', price:48,  label:'Short Bow'        },
];

const SHOP_ARMORS: Array<{
  baseId: string; mainId: string; backId: string; price: number; label: string;
}> = [
  { baseId:'helm_soft',  mainId:'cloth_1', backId:'pelt_1',  price:25, label:'Cloth Cap'    },
  { baseId:'helm_plate', mainId:'roughstone_1', backId:'cloth_1', price:55, label:'Stone Helm' },
  { baseId:'body_soft',  mainId:'cloth_1', backId:'pelt_1',  price:30, label:'Cloth Tunic'  },
  { baseId:'body_scale', mainId:'slough_1', backId:'cloth_1', price:65, label:'Scale Vest'  },
  { baseId:'legs_soft',  mainId:'cloth_1', backId:'pelt_1',  price:22, label:'Cloth Pants'  },
];

// ── Shared styles ──────────────────────────────────────────────────────────

const PANEL_BG  = 'rgba(10,10,10,0.96)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#f59e0b';
const TEXT_DIM  = '#666';
const TEXT_MED  = '#999';
const TEXT_MAIN = '#ddd';

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 14px', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
    background: active ? ACCENT : 'rgba(30,30,30,0.8)',
    color: active ? '#000' : TEXT_DIM,
    border: `1px solid ${active ? ACCENT : BORDER}`,
    borderRadius: 4, cursor: 'pointer', transition: 'all 0.15s',
    letterSpacing: 1,
  };
}

// ── Sub-components ────────────────────────────────────────────────────────

function ItemRow({
  name, desc, price, ether, canAfford, onBuy,
}: {
  name: string; desc: string; price: number; ether: number;
  canAfford: boolean; onBuy: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 8px', borderRadius: 4, marginBottom: 3,
      background: 'rgba(255,255,255,0.03)',
      border: `1px solid ${BORDER}`,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_MAIN }}>{name}</div>
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 1 }}>{desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div style={{
          fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
          color: canAfford ? ACCENT : '#ff4444',
        }}>
          ◆{price}
        </div>
        <button
          onClick={onBuy}
          disabled={!canAfford}
          style={{
            padding: '3px 10px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
            background: canAfford ? 'rgba(245,158,11,0.15)' : 'rgba(50,50,50,0.5)',
            color: canAfford ? ACCENT : '#444',
            border: `1px solid ${canAfford ? ACCENT + '55' : '#222'}`,
            borderRadius: 3, cursor: canAfford ? 'pointer' : 'default',
          }}
        >
          BUY
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────

export interface ShopPanelProps {
  ether:       number;
  inventory:   GameItem[];
  onClose:     () => void;
  onPurchase:  (item: GameItem, cost: number) => void;
  /** building_ids already placed (any state) — prevents duplicate deed purchase */
  placedIds:   Set<string>;
  /** building_ids with state === 'built' — used for unlock gating */
  builtIds:    Set<string>;
  onSpendEther: (amount: number) => void;
}

type ShopTab = 'consumables' | 'materials' | 'equipment' | 'machines';

export function ShopPanel({ ether, inventory: _inv, onClose, onPurchase, placedIds, builtIds, onSpendEther }: ShopPanelProps) {
  const [tab, setTab] = useState<ShopTab>('consumables');
  const [feedback, setFeedback] = useState<string | null>(null);

  const buy = (item: GameItem | null, cost: number, label: string) => {
    if (!item) { setFeedback('Crafting failed — missing materials.'); return; }
    if (ether < cost) { setFeedback('Not enough Ether!'); return; }
    onPurchase(item, cost);
    setFeedback(`Purchased: ${label}`);
    setTimeout(() => setFeedback(null), 2000);
  };

  // Build a potion GameItem from PotionDef
  const makePotionItem = (def: PotionDef): GameItem => ({
    id: `shop_${def.id}_${Date.now()}`,
    type: 'potion', name: def.name,
    slot: null, rarity: 0, quantity: 1, equipped: false,
    tint: parseInt(def.color.slice(1), 16),
  });

  const rng = Math.random;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        width: 480, maxHeight: '80vh',
        background: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: ACCENT, letterSpacing: 2 }}>
              ◈ PLAZA SHOP
            </div>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              Trade Ether for supplies and equipment
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              fontSize: 12, fontFamily: 'monospace', fontWeight: 700,
              color: ACCENT, background: 'rgba(245,158,11,0.1)',
              border: `1px solid ${ACCENT}44`, borderRadius: 4, padding: '3px 10px',
            }}>
              ◆ {ether}
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: TEXT_DIM,
              fontSize: 16, cursor: 'pointer', padding: '0 4px',
            }}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 6, padding: '10px 16px',
          borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          {(['consumables', 'materials', 'equipment', 'machines'] as ShopTab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={tabStyle(tab === t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Feedback */}
        {feedback && (
          <div style={{
            margin: '8px 16px 0', padding: '5px 10px', fontSize: 9,
            fontFamily: 'monospace', borderRadius: 3,
            background: feedback.includes('!') || feedback.includes('failed')
              ? 'rgba(255,68,68,0.12)' : 'rgba(68,255,120,0.10)',
            color: feedback.includes('!') || feedback.includes('failed') ? '#ff8888' : '#66ffaa',
            border: `1px solid ${feedback.includes('!') || feedback.includes('failed') ? '#ff444433' : '#44ff8833'}`,
          }}>
            {feedback}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px 16px' }}>

          {/* ── CONSUMABLES ── */}
          {tab === 'consumables' && (
            <div>
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 8 }}>
                HP POTIONS
              </div>
              {['hp_small','hp_medium','hp_large','hp_xl'].map(id => {
                const def = POTIONS[id];
                return (
                  <ItemRow
                    key={id}
                    name={def.name}
                    desc={`Restores ${def.healAmount} HP`}
                    price={def.buyPrice}
                    ether={ether}
                    canAfford={ether >= def.buyPrice}
                    onBuy={() => buy(makePotionItem(def), def.buyPrice, def.name)}
                  />
                );
              })}
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, margin: '12px 0 8px' }}>
                SPIRIT POTIONS
              </div>
              {['sp_small','sp_medium','sp_large','sp_xl'].map(id => {
                const def = POTIONS[id];
                return (
                  <ItemRow
                    key={id}
                    name={def.name}
                    desc={`Restores ${def.healAmount} SP`}
                    price={def.buyPrice}
                    ether={ether}
                    canAfford={ether >= def.buyPrice}
                    onBuy={() => buy(makePotionItem(def), def.buyPrice, def.name)}
                  />
                );
              })}
            </div>
          )}

          {/* ── MATERIALS ── */}
          {tab === 'materials' && (
            <div>
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', marginBottom: 8 }}>
                Tier-1 crafting materials only. Higher tiers must be refined or looted.
              </div>
              {ALL_MATERIALS.filter(m => m.tier === 1 && !m.id.includes('special')).map((mat: MaterialProps) => {
                const price = MATERIAL_SHOP_PRICE[mat.tier];
                const item: GameItem = {
                  id: `shop_${mat.id}_${Date.now()}`,
                  type: 'crafting_material', name: mat.name,
                  slot: null, rarity: 0, quantity: 1, equipped: false,
                  tint: typeof mat.tint === 'number' ? mat.tint : 0x888888,
                };
                return (
                  <ItemRow
                    key={mat.id}
                    name={mat.name}
                    desc={`${mat.category} · Tier ${mat.tier} · ${mat.roles.join(', ')}`}
                    price={price}
                    ether={ether}
                    canAfford={ether >= price}
                    onBuy={() => buy(item, price, mat.name)}
                  />
                );
              })}
            </div>
          )}

          {/* ── EQUIPMENT ── */}
          {tab === 'equipment' && (
            <div>
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 8 }}>
                WEAPONS
              </div>
              {SHOP_WEAPONS.map((sw, i) => {
                const item = craftWeapon(sw.baseId, sw.headId, sw.shaftId, sw.gripId, sw.element, rng);
                return (
                  <ItemRow
                    key={i}
                    name={sw.label}
                    desc={item
                      ? `${sw.element} · ${item.weaponStats?.dmgMin ?? '?'}–${item.weaponStats?.dmgMax ?? '?'} dmg · ${RARITIES[item.rarity].name}`
                      : 'Unavailable'}
                    price={sw.price}
                    ether={ether}
                    canAfford={ether >= sw.price && !!item}
                    onBuy={() => buy(item, sw.price, sw.label)}
                  />
                );
              })}
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, margin: '12px 0 8px' }}>
                ARMOR
              </div>
              {SHOP_ARMORS.map((sa, i) => {
                const item = craftArmor(sa.baseId, sa.mainId, sa.backId, rng);
                return (
                  <ItemRow
                    key={i}
                    name={sa.label}
                    desc={item
                      ? `Defense ${item.armorStats?.defense ?? '?'} · ${RARITIES[item.rarity].name}`
                      : 'Unavailable'}
                    price={sa.price}
                    ether={ether}
                    canAfford={ether >= sa.price && !!item}
                    onBuy={() => buy(item, sa.price, sa.label)}
                  />
                );
              })}
            </div>
          )}
          {/* ── MACHINES ── */}
          {tab === 'machines' && (() => {
            const plazaMachines = MACHINE_CATALOG.filter(m => m.vendor === 'plaza_shop');
            return (
              <div>
                <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', marginBottom: 8 }}>
                  Purchase a deed to enter placement mode. Place in your zone, then supply materials to build.
                </div>
                {plazaMachines.map(entry => {
                  const canAfford    = ether >= entry.etherCost;
                  const alreadyOwned = placedIds.has(entry.id);
                  const unlocked     = isMachineUnlocked(entry.id, builtIds);
                  const canBuy       = canAfford && unlocked && !alreadyOwned;

                  return (
                    <div key={entry.id} style={{
                      padding: '8px 10px', marginBottom: 6, borderRadius: 5,
                      background: 'rgba(255,255,255,0.02)',
                      border: `1px solid ${alreadyOwned ? '#4ade8033' : BORDER}`,
                      opacity: unlocked ? 1 : 0.5,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, color: TEXT_MAIN }}>
                            {entry.label}
                          </div>
                          <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
                            {entry.subtitle}
                          </div>
                          <div style={{ fontSize: 7, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 3 }}>
                            {entry.slots.map(s => `${s.label} (${s.points}pt)`).join(' · ')}
                          </div>
                          {alreadyOwned && (
                            <div style={{ fontSize: 7, fontFamily: 'monospace', color: '#4ade80', marginTop: 3, letterSpacing: 1 }}>
                              PLACED
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0, marginLeft: 12 }}>
                          <div style={{
                            fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
                            color: canAfford ? ACCENT : '#ef4444',
                          }}>
                            ◆{entry.etherCost}
                          </div>
                          <button
                            onClick={() => {
                              onClose();
                              BuildingPlacementOverlay.begin(
                                entry.id,
                                entry.label,
                                () => onSpendEther(entry.etherCost),
                              );
                            }}
                            disabled={!canBuy}
                            style={{
                              padding: '3px 10px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
                              background: canBuy ? 'rgba(245,158,11,0.15)' : 'rgba(30,30,30,0.5)',
                              color: canBuy ? ACCENT : TEXT_DIM,
                              border: `1px solid ${canBuy ? ACCENT + '55' : '#222'}`,
                              borderRadius: 3, cursor: canBuy ? 'pointer' : 'default',
                            }}
                          >
                            {alreadyOwned ? 'OWNED' : 'BUY DEED'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
